/**
 * learning/arm.ts — the INDEPENDENT verification arm (M6 Track 2).
 *
 * Between "skill written" and "skill trusted" sits this arm — three
 * sub-mechanisms, ALL EXECUTABLE (no prompt-based "does this look right"):
 *
 * 1. GENERATED TESTS — synthesized from the candidate's declared behavior
 *    contract, executed through the honesty judges framework (`runJudge`
 *    with frozen inputs + verdictId recomputation — reused, not rebuilt).
 * 2. EVALS — the skill runs against ARM-OWNED held-out eval cases; outcomes
 *    are measured (Hermes #96704: the measurement is built WITH the loop).
 * 3. SECOND-MODEL CRITIC — a DIFFERENT lane reviews the skill. Author ≠
 *    inspector is structural (Hermes #25833): `verify` fails with
 *    `AuthorInspectorCollision` when critic lane == author lane. The
 *    critic's verdict is recorded in the honesty ledger as EVIDENCE
 *    (kind "source") — never taken on assertion, never sufficient alone.
 *
 * The arm produces a VERIFICATION REPORT (pass/fail per mechanism +
 * evidence refs). Only a passing report can become a `VerifiedReport`:
 * the brand is minted solely by `finalize`, which requires overall pass
 * AND at least one executable evidence per mechanism. The evidence gate
 * (gate.ts) accepts ONLY `VerifiedReport` — prompt-only promotion is a
 * type error, not a policy.
 */
import { Clock, Context, Data, Effect, Layer } from "effect"

import { canonicalJson, sha256Hex } from "../../honesty/judges/src/canonical.js"
import { defineJudge, JudgeRegistry, runJudge } from "../../honesty/judges/src/index.js"
import type { JudgeInput } from "../../honesty/judges/src/contracts.js"
import { HonestyService, type HonestyError } from "../../honesty/src/index.js"
import type { CandidateSkill, EvalCase } from "./types.js"

export class ArmError extends Data.TaggedError("ArmError")<{
  readonly reason: string
}> {}

/** Hermes #25833: author and inspector must be structurally separate. */
export class AuthorInspectorCollision extends Data.TaggedError("AuthorInspectorCollision")<{
  readonly authorLane: string
  readonly criticLane: string
}> {}

export class ExecutorError extends Data.TaggedError("ExecutorError")<{
  readonly reason: string
}> {}

export class CriticError extends Data.TaggedError("CriticError")<{
  readonly reason: string
}> {}

/** `finalize` refused: the report is not backed by executable evidence. */
export class UnverifiedReport extends Data.TaggedError("UnverifiedReport")<{
  readonly skillId: string
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// The arm's judge: pure output-vs-expectation comparator over an actual run.
// The RUN is the evidence (side-effect record from the executor); the judge
// only compares. Executability lives in `runJudge`: frozen inputs,
// deterministic verdictId, runner-owned clock.
// ---------------------------------------------------------------------------

const skillCheckJudge = defineJudge({
  id: "aimy/skill-check",
  version: "1.0.0",
  description:
    "Executable skill assertion: the executor completed a run (side-effect record, outcome ok) AND the run's output canonically equals the expected value.",
  check: (input) => {
    const ran = input.sideEffects.some((s) => s.tool === "skill-executor" && s.outcome === "ok")
    if (!ran) {
      return {
        verdict: "fail" as const,
        reasons: ["no completed skill-executor run in side effects"],
        evidenceIds: [],
      }
    }
    const state = input.finalState as { readonly actual?: unknown; readonly expect?: unknown } | null
    const actual = canonicalJson(state?.actual)
    const expect = canonicalJson(state?.expect)
    if (!actual.ok) {
      return { verdict: "fail" as const, reasons: [`actual output not serializable: ${actual.reason}`], evidenceIds: [] }
    }
    if (!expect.ok) {
      return { verdict: "fail" as const, reasons: [`expected value not serializable: ${expect.reason}`], evidenceIds: [] }
    }
    if (actual.json !== expect.json) {
      return {
        verdict: "fail" as const,
        reasons: [
          "output mismatch",
          `actual:   ${actual.json.slice(0, 300)}`,
          `expected: ${expect.json.slice(0, 300)}`,
        ],
        evidenceIds: [],
      }
    }
    return {
      verdict: "pass" as const,
      reasons: ["executor ran ok; output matches expected value"],
      evidenceIds: [],
    }
  },
})

/** Registry carrying the arm's executable judges. Reuses the honesty judges framework. */
export const armJudges: JudgeRegistry = JudgeRegistry.from([skillCheckJudge])

export const SKILL_CHECK_JUDGE_ID = "aimy/skill-check"
export const SKILL_CHECK_JUDGE_RANGE = "^1.0.0"

// ---------------------------------------------------------------------------
// Injectable seams (deterministic in tests, real backends in production).
// ---------------------------------------------------------------------------

/** Runs the candidate against one input inside the T0 sandbox (see quarantine.ts). */
export interface SkillExecutor {
  readonly execute: (candidate: CandidateSkill, input: unknown) => Effect.Effect<unknown, ExecutorError>
}

export interface CriticReview {
  readonly lane: string
  readonly verdict: "pass" | "fail"
  readonly findings: ReadonlyArray<string>
  readonly reviewedAt: string
}

/** A DIFFERENT inference lane from the author. Enforced by `verify`. */
export interface CriticLane {
  readonly lane: string
  readonly review: (candidate: CandidateSkill) => Effect.Effect<CriticReview, CriticError>
}

export interface ArmConfigShape {
  readonly registry: JudgeRegistry
  readonly executor: SkillExecutor
  readonly critic: CriticLane
  /** Arm-owned held-out eval cases — the candidate never sees these. */
  readonly evalCases: ReadonlyArray<EvalCase>
}

export class ArmConfig extends Context.Service<ArmConfig, ArmConfigShape>()("aimy/learning/ArmConfig") {}

export const ArmConfigLive = (config: ArmConfigShape): Layer.Layer<ArmConfig> => Layer.succeed(ArmConfig, config)

// ---------------------------------------------------------------------------
// Verification report.
// ---------------------------------------------------------------------------

export type VerificationMechanism = "generated-tests" | "evals" | "critic"

export interface MechanismResult {
  readonly mechanism: VerificationMechanism
  readonly status: "pass" | "fail"
  /** Honesty-ledger evidence ids backing this mechanism's result. */
  readonly evidenceRefs: ReadonlyArray<string>
  /** Judge verdict ids (executable evidence) behind this mechanism. */
  readonly verdictIds: ReadonlyArray<string>
  readonly detail: string
}

export interface EvalMeasurement {
  readonly total: number
  readonly passed: number
  readonly passRate: number
}

export interface VerificationReport {
  readonly reportId: string
  readonly skillId: string
  readonly mechanisms: ReadonlyArray<MechanismResult>
  readonly overall: "pass" | "fail"
  /** Eval outcome measurement (Hermes #96704) — undefined only if evals never ran. */
  readonly measurement: EvalMeasurement | undefined
  readonly ranAt: string
}

// The brand: a module-private runtime symbol. Only `finalize` (in this
// module) can mint a `VerifiedReport`. Gate promotion (gate.ts) requires
// this type, so a prompt-only candidate can never clear the gate — not by
// policy, by type. The symbol is NOT exported: no other module can name it,
// so the brand is unforgeable outside this file.
const verifiedBrand: unique symbol = Symbol("aimy/learning/verified-report")

export interface VerifiedReport extends VerificationReport {
  readonly [verifiedBrand]: typeof verifiedBrand
}

/** Type guard for the brand (tests + gate defense-in-depth). */
export const isVerifiedReport = (report: VerificationReport): report is VerifiedReport =>
  verifiedBrand in report

// ---------------------------------------------------------------------------
// The arm service.
// ---------------------------------------------------------------------------

export interface VerificationArmShape {
  /**
   * Run all three mechanisms against the candidate and produce a report.
   * Fails typed on structural violations (author==inspector) or broken
   * infrastructure — a candidate that merely FAILS gets a failing report,
   * never a thrown error.
   */
  readonly verify: (
    candidate: CandidateSkill,
  ) => Effect.Effect<VerificationReport, ArmError | AuthorInspectorCollision | CriticError | HonestyError>
  /**
   * Mint a `VerifiedReport` from a passing report. Fails `UnverifiedReport`
   * unless overall is pass AND every mechanism carries executable evidence.
   * This is the constructor-level impossibility: there is no other way to
   * obtain the brand.
   */
  readonly finalize: (report: VerificationReport) => Effect.Effect<VerifiedReport, UnverifiedReport>
}

export class VerificationArm extends Context.Service<VerificationArm, VerificationArmShape>()(
  "aimy/learning/VerificationArm",
) {}

const reportIdFor = (skillId: string, ranAt: string, statuses: ReadonlyArray<string>): string =>
  `vr:${sha256Hex(`${skillId}|${ranAt}|${statuses.join(",")}`).slice(0, 16)}`

const judgeInputFor = (
  taskId: string,
  claim: string,
  actual: { readonly ok: boolean; readonly value: unknown; readonly error: string },
  expect: unknown,
): JudgeInput => ({
  taskId,
  claim,
  finalState: { actual: actual.value, expect },
  sideEffects: [
    {
      toolCallId: `${taskId}:run`,
      tool: "skill-executor",
      args: {},
      outcome: actual.ok ? "ok" : "io-error",
      resultSummary: actual.ok ? "executor completed" : `executor failed: ${actual.error.slice(0, 200)}`,
    },
  ],
  dialogue: [],
})

interface ExecutedCheck {
  readonly verdictId: string
  readonly evidenceId: string
  readonly passed: boolean
}

export const VerificationArmLive: Layer.Layer<VerificationArm, never, HonestyService | ArmConfig> = Layer.effect(
  VerificationArm,
  Effect.gen(function* () {
    const honesty = yield* HonestyService
    const config = yield* ArmConfig

    /** Run one input through the executor, then the judge. Executor failure becomes a failed check, not a throw. */
    const runCheck = (
      candidate: CandidateSkill,
      taskId: string,
      claim: string,
      input: unknown,
      expect: unknown,
      claimId: string,
    ): Effect.Effect<ExecutedCheck, ArmError | HonestyError> =>
      Effect.gen(function* () {
        const outcome = yield* config.executor
          .execute(candidate, input)
          .pipe(
            Effect.map((value) => ({ ok: true as const, value, error: "" })),
            Effect.catch((e: unknown) => {
              const reason = e instanceof ExecutorError ? e.reason : String(e)
              return Effect.succeed({ ok: false as const, value: null, error: reason })
            }),
          )
        const judgeInput = judgeInputFor(taskId, claim, outcome, expect)
        const verdict = yield* runJudge(config.registry, SKILL_CHECK_JUDGE_ID, SKILL_CHECK_JUDGE_RANGE, judgeInput).pipe(
          Effect.mapError((e) => new ArmError({ reason: `judge infrastructure failure: ${e._tag}` })),
        )
        yield* honesty.recordVerdict(verdict)
        const evidence = yield* honesty.attachEvidence(claimId, {
          kind: "judge-verdict",
          ref: verdict.verdictId,
          summary: `${taskId}: ${verdict.verdict}`,
        })
        return { verdictId: verdict.verdictId, evidenceId: evidence.evidenceId, passed: verdict.verdict === "pass" }
      })

    const verify: VerificationArmShape["verify"] = (candidate) =>
      Effect.gen(function* () {
        // Hermes #25833 — structural: the inspector lane must differ from the author lane.
        if (config.critic.lane === candidate.authorLane) {
          return yield* Effect.fail(
            new AuthorInspectorCollision({ authorLane: candidate.authorLane, criticLane: config.critic.lane }),
          )
        }
        const ranAt = yield* Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
        const claim = yield* honesty.recordClaim({
          sessionId: "learning",
          turnId: `verify:${candidate.skillId}`,
          text: `candidate skill ${candidate.name} v${candidate.version} is safe to trust`,
          kind: "task-result",
        })

        // --- Mechanism 1: generated tests (from the candidate's declared contract).
        const generatedChecks: Array<ExecutedCheck> = []
        for (const c of candidate.behaviorCases) {
          generatedChecks.push(
            yield* runCheck(
              candidate,
              `behavior:${candidate.skillId}:${c.caseId}`,
              `skill ${candidate.skillId} satisfies behavior case ${c.caseId}: ${c.description}`,
              c.input,
              c.expect,
              claim.claimId,
            ),
          )
        }
        const generatedTests: MechanismResult = {
          mechanism: "generated-tests",
          status: generatedChecks.length > 0 && generatedChecks.every((c) => c.passed) ? "pass" : "fail",
          evidenceRefs: generatedChecks.map((c) => c.evidenceId),
          verdictIds: generatedChecks.map((c) => c.verdictId),
          detail:
            generatedChecks.length === 0
              ? "no executable checks: candidate declares no behavior contract (prompt-only)"
              : `${generatedChecks.filter((c) => c.passed).length}/${generatedChecks.length} generated tests passed`,
        }

        // --- Mechanism 2: evals (arm-owned held-out cases; outcomes measured).
        const evalChecks: Array<ExecutedCheck> = []
        for (const e of config.evalCases) {
          evalChecks.push(
            yield* runCheck(
              candidate,
              `eval:${candidate.skillId}:${e.evalId}`,
              `skill ${candidate.skillId} satisfies held-out eval ${e.evalId}: ${e.description}`,
              e.input,
              e.expect,
              claim.claimId,
            ),
          )
        }
        const passedEvals = evalChecks.filter((c) => c.passed).length
        const measurement: EvalMeasurement = {
          total: evalChecks.length,
          passed: passedEvals,
          passRate: evalChecks.length === 0 ? 0 : passedEvals / evalChecks.length,
        }
        const evals: MechanismResult = {
          mechanism: "evals",
          status: evalChecks.length > 0 && passedEvals === evalChecks.length ? "pass" : "fail",
          evidenceRefs: evalChecks.map((c) => c.evidenceId),
          verdictIds: evalChecks.map((c) => c.verdictId),
          detail: `measured pass rate ${passedEvals}/${evalChecks.length}`,
        }

        // --- Mechanism 3: second-model critic (different lane; verdict RECORDED as evidence, not asserted).
        const review = yield* config.critic.review(candidate).pipe(
          Effect.mapError((e: unknown) =>
            e instanceof CriticError ? e : new CriticError({ reason: `critic infrastructure failure: ${String(e)}` }),
          ),
        )
        const criticEvidence = yield* honesty.attachEvidence(claim.claimId, {
          kind: "source",
          ref: `critic:${review.lane}:${sha256Hex(canonicalJson(review.findings).json).slice(0, 12)}`,
          summary: `critic lane ${review.lane}: ${review.verdict} (${review.findings.length} findings)`,
        })
        const critic: MechanismResult = {
          mechanism: "critic",
          status: review.verdict,
          evidenceRefs: [criticEvidence.evidenceId],
          verdictIds: [],
          detail: `critic lane ${review.lane} verdict: ${review.verdict}; recorded as evidence, not taken on assertion`,
        }

        const mechanisms = [generatedTests, evals, critic] as const
        const overall = mechanisms.every((m) => m.status === "pass") ? "pass" : "fail"
        return {
          reportId: reportIdFor(candidate.skillId, ranAt, mechanisms.map((m) => `${m.mechanism}:${m.status}`)),
          skillId: candidate.skillId,
          mechanisms: [...mechanisms],
          overall,
          measurement,
          ranAt,
        } satisfies VerificationReport
      })

    const finalize: VerificationArmShape["finalize"] = (report) =>
      Effect.gen(function* () {
        // THE HARD RULE, enforced at the brand constructor: a passing report
        // is not enough — every mechanism must carry EXECUTABLE evidence.
        // A "verified" claim backed only by model assertion (no judge verdicts,
        // no recorded critic run) can never mint the brand.
        const byName = new Map(report.mechanisms.map((m) => [m.mechanism, m]))
        const generated = byName.get("generated-tests")
        const evals = byName.get("evals")
        const critic = byName.get("critic")
        const missing: Array<string> = []
        if (!generated || generated.status !== "pass" || generated.verdictIds.length === 0) {
          missing.push("generated-tests: no passing executable checks (prompt-only)")
        }
        if (!evals || evals.status !== "pass" || evals.verdictIds.length === 0) {
          missing.push("evals: no passing executable checks (prompt-only)")
        }
        if (!critic || critic.status !== "pass" || critic.evidenceRefs.length === 0) {
          missing.push("critic: no recorded critic evidence")
        }
        if (report.overall !== "pass" || missing.length > 0) {
          return yield* Effect.fail(
            new UnverifiedReport({
              skillId: report.skillId,
              reason: `prompt-only or incomplete evidence (overall=${report.overall}): ${missing.join("; ")}`,
            }),
          )
        }
        return { ...report, [verifiedBrand]: verifiedBrand } as VerifiedReport
      })

    return VerificationArm.of({ verify, finalize })
  }),
)


