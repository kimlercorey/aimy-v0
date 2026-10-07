/**
 * Track 2 — verification arm tests.
 *
 * The arm's three mechanisms are all executable: generated tests and evals
 * run through the honesty judges framework (`runJudge` — frozen inputs,
 * deterministic verdictIds), and the second-model critic is a different
 * lane whose verdict is RECORDED in the ledger as evidence, never taken
 * on assertion.
 *
 * The headline invariant: a prompt-only candidate (LLM assertion, no
 * executable checks) can never mint a VerifiedReport.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  AuthorInspectorCollision,
  isVerifiedReport,
  UnverifiedReport,
  VerificationArm,
  type MechanismResult,
  type VerificationArmShape,
} from "../src/arm.js"
import { HonestyService, type HonestyServiceShape } from "../../honesty/src/index.js"
import {
  brokenCritic,
  crashingExecutor,
  failCritic,
  makeCandidate,
  makePromptOnlyCandidate,
  passCritic,
  testArmConfig,
  testEvalCases,
  testLayers,
} from "./fixtures.js"

const withArm = <A, E, R>(
  use: (arm: VerificationArmShape, honesty: HonestyServiceShape) => Effect.Effect<A, E, R>,
  armConfig = testArmConfig(),
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const arm = yield* VerificationArm
    const honesty = yield* HonestyService
    return yield* use(arm, honesty)
  }).pipe(Effect.provide(testLayers(armConfig)))

const byName = (report: { mechanisms: ReadonlyArray<MechanismResult> }, name: string) =>
  report.mechanisms.find((m) => m.mechanism === name)!

describe("VerificationArm", () => {
  it.effect("passing candidate: all three mechanisms pass with executable evidence", () =>
    withArm((arm) =>
      Effect.gen(function* () {
        const report = yield* arm.verify(makeCandidate())
        expect(report.overall).toBe("pass")
        expect(report.mechanisms.map((m) => m.mechanism)).toEqual(["generated-tests", "evals", "critic"])
        for (const m of report.mechanisms) {
          expect(m.status).toBe("pass")
          expect(m.evidenceRefs.length).toBeGreaterThan(0)
        }
        const generated = byName(report, "generated-tests")
        const evals = byName(report, "evals")
        expect(generated.verdictIds.length).toBe(1)
        expect(evals.verdictIds.length).toBe(testEvalCases.length)
        expect(report.measurement).toEqual({ total: 2, passed: 2, passRate: 1 })
        const verified = yield* arm.finalize(report)
        expect(isVerifiedReport(verified)).toBe(true)
        expect(verified.reportId).toBe(report.reportId)
      }),
    ),
  )

  it.effect("generated test failure: wrong output fails the mechanism and the report", () =>
    withArm((arm) =>
      Effect.gen(function* () {
        const bad = makeCandidate({
          behaviorCases: [{ caseId: "case-1", description: "wrong", input: { q: 1 }, expect: { not: "echo" } }],
        })
        const report = yield* arm.verify(bad)
        expect(byName(report, "generated-tests").status).toBe("fail")
        expect(byName(report, "generated-tests").detail).toContain("0/1")
        expect(report.overall).toBe("fail")
        const err = yield* Effect.flip(arm.finalize(report))
        expect(err).toBeInstanceOf(UnverifiedReport)
      }),
    ),
  )

  it.effect("eval measurement records pass rate 1/2 on a partial pass", () =>
    withArm(
      (arm) =>
        Effect.gen(function* () {
          const report = yield* arm.verify(makeCandidate())
          expect(report.measurement).toEqual({ total: 2, passed: 1, passRate: 0.5 })
          expect(byName(report, "evals").status).toBe("fail")
          expect(report.overall).toBe("fail")
        }),
      testArmConfig({
        evalCases: [
          { evalId: "eval-1", description: "passes", input: { q: 1 }, expect: { echo: { q: 1 } } },
          { evalId: "eval-2", description: "fails", input: { q: 2 }, expect: { echo: { q: 999 } } },
        ],
      }),
    ),
  )

  it.effect("critic on the author's lane is a structural collision (Hermes #25833)", () =>
    withArm(
      (arm) =>
        Effect.gen(function* () {
          const candidate = makeCandidate({ authorLane: "review-fork:fork-1" })
          const err = yield* Effect.flip(arm.verify(candidate))
          expect(err).toBeInstanceOf(AuthorInspectorCollision)
          if (!(err instanceof AuthorInspectorCollision)) throw new Error("expected AuthorInspectorCollision")
          expect(err.authorLane).toBe("review-fork:fork-1")
          expect(err.criticLane).toBe("review-fork:fork-1")
        }),
      testArmConfig({ critic: passCritic("review-fork:fork-1") }),
    ),
  )

  it.effect("critic fail fails the report even when tests and evals pass", () =>
    withArm(
      (arm) =>
        Effect.gen(function* () {
          const report = yield* arm.verify(makeCandidate())
          expect(byName(report, "generated-tests").status).toBe("pass")
          expect(byName(report, "evals").status).toBe("pass")
          expect(byName(report, "critic").status).toBe("fail")
          expect(report.overall).toBe("fail")
        }),
      testArmConfig({ critic: failCritic("aux-critic-lane", ["hallucinated tool"]) }),
    ),
  )

  it.effect("critic verdict is RECORDED in the honesty ledger as evidence, not asserted", () =>
    withArm((arm, honesty) =>
      Effect.gen(function* () {
        const candidate = makeCandidate()
        yield* arm.verify(candidate)
        const claims = yield* honesty.claimsForTurn("learning", `verify:${candidate.skillId}`)
        expect(claims.length).toBe(1)
        const evidence = yield* honesty.evidenceFor(claims[0]!.claim.claimId)
        const kinds = evidence.map((e) => e.kind)
        // Judge verdicts (executable) AND the critic review (source record).
        expect(kinds).toContain("judge-verdict")
        expect(kinds).toContain("source")
        const criticEvidence = evidence.find((e) => e.kind === "source")!
        expect(criticEvidence.ref).toContain("critic:aux-critic-lane")
        expect(criticEvidence.summary).toContain("pass")
      }),
    ),
  )

  it.effect("executor crash becomes a failed check, never a thrown error", () =>
    withArm(
      (arm) =>
        Effect.gen(function* () {
          const report = yield* arm.verify(makeCandidate())
          expect(byName(report, "generated-tests").status).toBe("fail")
          expect(byName(report, "generated-tests").detail).toContain("0/1")
          expect(report.overall).toBe("fail")
        }),
      testArmConfig({ executor: crashingExecutor }),
    ),
  )

  it.effect("broken critic lane fails verification typed (no silent pass)", () =>
    withArm(
      (arm) =>
        Effect.gen(function* () {
          const err = yield* Effect.flip(arm.verify(makeCandidate()))
          // CriticError surfaces; the arm never invents a critic verdict.
          expect(err._tag).toBe("CriticError")
        }),
      testArmConfig({ critic: brokenCritic("aux-critic-lane") }),
    ),
  )

  it.effect("PROMPT-ONLY REJECTION PROOF: assertion without executable checks can never verify", () =>
    withArm(
      (arm) =>
        Effect.gen(function* () {
          const candidate = makePromptOnlyCandidate()
          const report = yield* arm.verify(candidate)
          // All three mechanisms fail: no behavior contract -> no checks;
          // no held-out evals -> nothing measured; critic pass is recorded
          // evidence but never sufficient alone.
          expect(byName(report, "generated-tests").status).toBe("fail")
          expect(byName(report, "generated-tests").detail).toContain("prompt-only")
          expect(byName(report, "generated-tests").verdictIds).toEqual([])
          expect(byName(report, "evals").status).toBe("fail")
          expect(byName(report, "critic").status).toBe("pass") // assertion recorded...
          expect(byName(report, "critic").evidenceRefs.length).toBe(1)
          expect(report.overall).toBe("fail")
          // ...but the brand is unmintable: finalize refuses, typed.
          const err = yield* Effect.flip(arm.finalize(report))
          expect(err).toBeInstanceOf(UnverifiedReport)
          expect(err.skillId).toBe(candidate.skillId)
          expect(err.reason).toContain("prompt-only")
          expect(isVerifiedReport(report)).toBe(false)
        }),
      testArmConfig({ evalCases: [] }),
    ),
  )

  it.effect("finalize refuses a passing-shaped report with no executable evidence (defense in depth)", () =>
    withArm((arm) =>
      Effect.gen(function* () {
        // A report that CLAIMS pass but carries no verdicts — the shape a
        // prompt-only pipeline would produce. finalize must refuse it.
        const forged = {
          reportId: "vr:forged",
          skillId: "skill-echo",
          mechanisms: [
            { mechanism: "generated-tests", status: "pass", evidenceRefs: ["ev-1"], verdictIds: [], detail: "trust me" },
            { mechanism: "evals", status: "pass", evidenceRefs: ["ev-2"], verdictIds: [], detail: "trust me" },
            { mechanism: "critic", status: "pass", evidenceRefs: ["ev-3"], verdictIds: [], detail: "trust me" },
          ],
          overall: "pass",
          measurement: undefined,
          ranAt: new Date().toISOString(),
        } as const
        const err = yield* Effect.flip(arm.finalize(forged))
        expect(err).toBeInstanceOf(UnverifiedReport)
        expect(err.reason).toContain("no passing executable checks")
      }),
    ),
  )

  it.effect("echoExecutor is actually exercised (sanity: executor output flows into the judge)", () =>
    withArm((arm) =>
      Effect.gen(function* () {
        // If the executor were bypassed, this passing case would be
        // indistinguishable from a prompt-only pass. The verdict ids prove
        // judge runs happened.
        const report = yield* arm.verify(makeCandidate())
        const verdictIds = report.mechanisms.flatMap((m) => m.verdictIds)
        expect(verdictIds.length).toBe(1 + testEvalCases.length)
        expect(new Set(verdictIds).size).toBe(verdictIds.length) // deterministic + distinct
      }),
    ),
  )
})
