/**
 * learning/test/fixtures.ts — shared deterministic fixtures for Track 2 tests.
 *
 * - `echoExecutor`: a SkillExecutor that returns `{ echo: input }`. Behavior
 *   cases whose `expect` matches this pass; anything else fails. No I/O,
 *   no network, fully deterministic.
 * - Critics are pure stubs on named lanes.
 * - `testLayers`: one composed layer tree providing VerificationArm,
 *   EvidenceGate, Curator, QuarantineStore, and HonestyService (in-memory).
 *   Each service tag appears exactly once.
 * - `verifyPassing`: runs the real arm + finalize to mint a VerifiedReport.
 *   Tests NEVER forge the brand.
 */
import { Effect, Layer } from "effect"

import { HonestyService, HonestyServiceInMemory } from "../../honesty/src/index.js"
import {
  armJudges,
  ArmConfig,
  ArmConfigLive,
  CriticError,
  ExecutorError,
  VerificationArm,
  VerificationArmLive,
  type ArmConfigShape,
  type CriticLane,
  type SkillExecutor,
  type VerifiedReport,
} from "../src/arm.js"
import { Curator, CuratorConfig, CuratorConfigLive, CuratorLive } from "../src/curator.js"
import { EvidenceGate, EvidenceGateLive } from "../src/gate.js"
import { QuarantineStore, QuarantineStoreLive } from "../src/quarantine.js"
import type { CandidateSkill, EvalCase } from "../src/types.js"

/** Deterministic executor: output is `{ echo: input }`. */
export const echoExecutor: SkillExecutor = {
  execute: (_candidate, input) => Effect.succeed({ echo: input }),
}

/** Executor that always crashes — executor failure must become a failed check, never a throw. */
export const crashingExecutor: SkillExecutor = {
  execute: (_candidate, _input) => Effect.fail(new ExecutorError({ reason: "executor crashed" })),
}

export const passCritic = (lane: string): CriticLane => ({
  lane,
  review: (candidate) =>
    Effect.succeed({ lane, verdict: "pass" as const, findings: [], reviewedAt: candidate.proposedAt }),
})

export const failCritic = (lane: string, findings: ReadonlyArray<string>): CriticLane => ({
  lane,
  review: (candidate) =>
    Effect.succeed({ lane, verdict: "fail" as const, findings: [...findings], reviewedAt: candidate.proposedAt }),
})

export const brokenCritic = (lane: string): CriticLane => ({
  lane,
  review: (_candidate) => Effect.fail(new CriticError({ reason: "critic lane unreachable" })),
})

/** Arm-owned held-out eval cases (the candidate never sees these). */
export const testEvalCases: ReadonlyArray<EvalCase> = [
  { evalId: "eval-1", description: "held-out eval one", input: { q: 1 }, expect: { echo: { q: 1 } } },
  { evalId: "eval-2", description: "held-out eval two", input: { q: 2 }, expect: { echo: { q: 2 } } },
]

export const makeCandidate = (overrides?: Partial<CandidateSkill>): CandidateSkill => ({
  skillId: "skill-echo",
  name: "echo-skill",
  version: "0.1.0",
  skillMd: "---\nname: echo-skill\nversion: 0.1.0\n---\nEchoes its input.",
  authorLane: "review-fork:fork-1",
  authorKind: "model",
  proposedAt: "2026-10-07T06:00:00.000Z",
  behaviorCases: [{ caseId: "case-1", description: "echoes input", input: { q: 1 }, expect: { echo: { q: 1 } } }],
  coveredCases: [],
  ...overrides,
})

/** A prompt-only candidate: no executable contract, only assertion. */
export const makePromptOnlyCandidate = (skillId = "skill-prompt-only"): CandidateSkill =>
  makeCandidate({
    skillId,
    name: "prompt-only-skill",
    behaviorCases: [],
    coveredCases: [],
    skillMd: "---\nname: prompt-only-skill\n---\nTrust me, this skill works. No tests needed.",
  })

export const testArmConfig = (overrides?: Partial<ArmConfigShape>): ArmConfigShape => ({
  registry: armJudges,
  executor: echoExecutor,
  critic: passCritic("aux-critic-lane"),
  evalCases: testEvalCases,
  ...overrides,
})

export const testCuratorConfig = { staleAfterDays: 30, archiveAfterDays: 90 } as const

/**
 * One composed layer tree. Each service tag appears exactly once, so the
 * gate and the test share the SAME QuarantineStore and HonestyService.
 */
export const testLayers = (
  armConfig?: ArmConfigShape,
): Layer.Layer<VerificationArm | EvidenceGate | Curator | QuarantineStore | HonestyService> => {
  // NOTE (Effect 4.0.1, verified empirically): Layer.merge does NOT wire one
  // side's outputs into the other side's requirements at runtime — the gate's
  // QuarantineStore requirement was unsatisfied inside a merge. Nested
  // Layer.provide is the wiring combinator. The shared `base` object is
  // memoized by identity within a build (verified), so the gate and the
  // tests share ONE QuarantineStore / HonestyService.
  const base = Layer.mergeAll(
    QuarantineStoreLive,
    HonestyServiceInMemory,
    ArmConfigLive(armConfig ?? testArmConfig()),
    CuratorConfigLive({ ...testCuratorConfig }),
  )
  return Layer.mergeAll(
    base,
    Layer.provide(VerificationArmLive, base),
    Layer.provide(EvidenceGateLive, base),
    Layer.provide(CuratorLive, base),
  )
}

/** Run the real arm + finalize to mint a VerifiedReport. Fails if verification fails. */
export const verifyPassing = (
  candidate: CandidateSkill,
  armConfig?: ArmConfigShape,
): Effect.Effect<VerifiedReport, unknown> =>
  Effect.gen(function* () {
    const arm = yield* VerificationArm
    const report = yield* arm.verify(candidate)
    return yield* arm.finalize(report)
  }).pipe(Effect.provide(testLayers(armConfig)))
