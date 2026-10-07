/**
 * M6 ACCEPTANCE DEMO — the agent learns a skill from experience.
 *
 * Positive path: a review fork proposes a skill → quarantine → verification
 * arm (executable checks) → evidence gate → trusted, with the learning
 * timeline showing staged → verifying → trusted and the evidence report
 * attached at each transition.
 *
 * Negative path: a prompt-only candidate (LLM assertion, no executable
 * checks) is REJECTED at the gate — proving the Hermes #25833 structural
 * fix. It stays quarantined, never live.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { VerificationArm, type VerificationArmShape } from "../src/arm.js"
import { EvidenceGate, type EvidenceGateShape } from "../src/gate.js"
import { QuarantineStore, type QuarantineStoreShape } from "../src/quarantine.js"
import {
  InMemoryTimelineStore,
  LearningTimeline,
  LearningTimelineLive,
  type LearningTimelineShape,
} from "../src/timeline.js"
import type { Provenance } from "../src/timeline.js"
import { makeCandidate, makePromptOnlyCandidate, testLayers } from "./fixtures.js"

const PROV: Provenance = {
  origin: "review-fork",
  sessionId: "m6-demo-session",
  profileId: "m6-demo-profile",
  runId: "m6-demo-run",
}

const withStack = <A, E>(
  use: (
    deps: {
      arm: VerificationArmShape
      gate: EvidenceGateShape
      quarantine: QuarantineStoreShape
      timeline: LearningTimelineShape
    },
  ) => Effect.Effect<A, E, VerificationArm | EvidenceGate | QuarantineStore | LearningTimeline>,
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const arm = yield* VerificationArm
    const gate = yield* EvidenceGate
    const quarantine = yield* QuarantineStore
    const timeline = yield* LearningTimeline
    return yield* use({ arm, gate, quarantine, timeline })
    // testLayers() + LearningTimelineLive provide every service the demo
    // uses — the cast bridges the generic R.
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        testLayers(),
        Layer.provide(LearningTimelineLive, InMemoryTimelineStore),
      ),
    ),
  ) as Effect.Effect<A, E, never>

describe("M6 acceptance: learning a skill from experience", () => {
  it.effect("skill goes staged → verified → trusted with evidence attached", () =>
    withStack(({ arm, gate, quarantine, timeline }) =>
      Effect.gen(function* () {
        const candidate = makeCandidate({ skillId: "skill-demo-echo" })

        // 1. Review fork proposes the skill.
        yield* timeline.recordEvent({
          type: "review-fork.proposed-add",
          provenance: PROV,
          subject: candidate.skillId,
          evidenceIds: [],
          payload: { store: "skills", summary: "echo skill learned from repeated user corrections" },
        })

        // 2. Quarantine: structural holding state.
        const q0 = yield* quarantine.quarantine(candidate)
        expect(q0.state).toBe("quarantined")

        // 3. Verification arm runs the three executable mechanisms.
        yield* quarantine.markVerifying(candidate.skillId)
        yield* timeline.recordEvent({
          type: "verification.started",
          provenance: { ...PROV, origin: "verification-arm" },
          subject: candidate.skillId,
          evidenceIds: [],
          payload: { judgeIds: ["aimy/skill-check@1.0.0"] },
        })
        const report = yield* arm.verify(candidate)
        expect(report.overall).toBe("pass")
        for (const m of report.mechanisms) {
          expect(m.status).toBe("pass")
          expect(m.evidenceRefs.length).toBeGreaterThan(0)
        }
        const verified = yield* arm.finalize(report)
        const verdictIds = report.mechanisms.flatMap((m) => m.verdictIds)
        const evidenceIds = report.mechanisms.flatMap((m) => m.evidenceRefs)
        yield* timeline.recordEvent({
          type: "verification.passed",
          provenance: { ...PROV, origin: "verification-arm" },
          subject: candidate.skillId,
          evidenceIds,
          payload: { verdictIds },
        })

        // 4. Evidence gate promotes to trusted.
        const trusted = yield* gate.promote(verified)
        expect(trusted.state).toBe("trusted")
        yield* timeline.recordEvent({
          type: "skill.trusted",
          provenance: { ...PROV, origin: "verification-arm" },
          subject: candidate.skillId,
          evidenceIds,
          payload: { judgeVersions: ["aimy/skill-check@1.0.0"] },
        })

        // 5. The timeline shows the full journey with evidence attached.
        const nodes = yield* timeline.query({ subject: candidate.skillId })
        const types = nodes.map((n) => n.type)
        expect(types).toEqual([
          "review-fork.proposed-add",
          "verification.started",
          "verification.passed",
          "skill.trusted",
        ])
        const trustedNode = nodes.find((n) => n.type === "skill.trusted")!
        expect(trustedNode.evidenceIds.length).toBeGreaterThan(0)

        // 6. The skill is now resolvable for live tasks (was impossible in quarantine).
        const live = yield* quarantine.resolveForLive(candidate.skillId)
        expect(live.state).toBe("trusted")
      }),
    ),
  )

  it.effect("prompt-only candidate is REJECTED at the gate and stays quarantined", () =>
    withStack(({ arm, gate, quarantine, timeline }) =>
      Effect.gen(function* () {
        const candidate = makePromptOnlyCandidate("skill-demo-prompt-only")

        yield* timeline.recordEvent({
          type: "review-fork.proposed-add",
          provenance: PROV,
          subject: candidate.skillId,
          evidenceIds: [],
          payload: { store: "skills", summary: "skill claimed by assertion only" },
        })
        const q0 = yield* quarantine.quarantine(candidate)
        expect(q0.state).toBe("quarantined")
        yield* quarantine.markVerifying(candidate.skillId)

        // The arm runs: generated tests find no executable checks, evals fail.
        const report = yield* arm.verify(candidate)
        expect(report.overall).toBe("fail")
        yield* timeline.recordEvent({
          type: "verification.failed",
          provenance: { ...PROV, origin: "verification-arm" },
          subject: candidate.skillId,
          evidenceIds: [],
          payload: {
            verdictIds: [],
            reasons: report.mechanisms.filter((m) => m.status !== "pass").map((m) => m.detail),
          },
        })

        // finalize refuses to mint a VerifiedReport for prompt-only evidence.
        const finalized = yield* Effect.exit(arm.finalize(report))
        expect(finalized._tag).toBe("Failure")

        // The gate records the rejection; the skill stays quarantined, never live.
        const rejected = yield* gate.reject(candidate.skillId, report, "prompt-only evidence")
        expect(rejected.state).toBe("rejected")
        yield* timeline.recordEvent({
          type: "skill.rejected",
          provenance: { ...PROV, origin: "verification-arm" },
          subject: candidate.skillId,
          evidenceIds: [],
          payload: { reasons: ["prompt-only evidence: no executable checks"] },
        })

        const nodes = yield* timeline.query({ subject: candidate.skillId })
        expect(nodes.map((n) => n.type)).toEqual([
          "review-fork.proposed-add",
          "verification.failed",
          "skill.rejected",
        ])
        const liveAttempt = yield* Effect.exit(quarantine.resolveForLive(candidate.skillId))
        expect(liveAttempt._tag).toBe("Failure")
      }),
    ),
  )
})
