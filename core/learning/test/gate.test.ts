/**
 * Track 2 — evidence gate tests.
 *
 * The gate promotes quarantined → trusted ONLY on a VerifiedReport.
 * Prompt-only promotion is a type error (the brand cannot be minted
 * without executable evidence); the gate ALSO re-validates at runtime
 * (defense in depth). Rejections are recorded in the ledger, never silent.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { GateRejection, EvidenceGate, type EvidenceGateShape } from "../src/gate.js"
import { isVerifiedReport, VerificationArm, type VerifiedReport } from "../src/arm.js"
import { HonestyService, type HonestyServiceShape } from "../../honesty/src/index.js"
import { QuarantineError, QuarantineStore, type QuarantineStoreShape } from "../src/quarantine.js"
import { makeCandidate, makePromptOnlyCandidate, testArmConfig, testLayers, verifyPassing } from "./fixtures.js"

const withGate = <A, E>(
  use: (
    gate: EvidenceGateShape,
    store: QuarantineStoreShape,
    honesty: HonestyServiceShape,
  ) => Effect.Effect<A, E, VerificationArm | EvidenceGate | QuarantineStore | HonestyService>,
  armConfig = testArmConfig(),
): Effect.Effect<A, E, never> =>
  Effect.gen(function* () {
    const gate = yield* EvidenceGate
    const store = yield* QuarantineStore
    const honesty = yield* HonestyService
    return yield* use(gate, store, honesty)
  }).pipe(Effect.provide(testLayers(armConfig))) as Effect.Effect<A, E, never>

describe("EvidenceGate", () => {
  it.effect("full pipeline: quarantine -> verify -> finalize -> promote -> trusted -> live", () =>
    withGate((gate, store, honesty) =>
      Effect.gen(function* () {
        const candidate = makeCandidate({ skillId: "skill-pipeline" })
        yield* store.quarantine(candidate)
        yield* store.markVerifying(candidate.skillId)
        const verified = yield* verifyPassing(candidate)
        const record = yield* gate.promote(verified)
        expect(record.state).toBe("trusted")
        expect(record.reportId).toBe(verified.reportId)
        expect(record.evidenceRefs.length).toBeGreaterThan(0)
        // History is append-only and names the report.
        expect(record.history.map((h) => `${h.from}->${h.to}`)).toEqual([
          "quarantined->quarantined",
          "quarantined->verifying",
          "verifying->trusted",
        ])
        // Live resolution now succeeds.
        expect((yield* store.resolveForLive(candidate.skillId)).state).toBe("trusted")
        // The promotion is in the honesty ledger.
        const claims = yield* honesty.claimsForTurn("learning", `gate:${candidate.skillId}`)
        expect(claims.length).toBe(1)
        expect(claims[0]!.claim.text).toContain("PROMOTED")
      }),
    ),
  )

  it.effect("promote re-validates at runtime: forged pass-shaped report is rejected", () =>
    withGate((gate, store) =>
      Effect.gen(function* () {
        yield* store.quarantine(makeCandidate({ skillId: "skill-forged" }))
        // Smuggle a pass-shaped value past the type system: no verdict ids,
        // no real evidence — exactly what a prompt-only pipeline would hand
        // the gate. The gate must fail closed.
        const forged = {
          reportId: "vr:forged",
          skillId: "skill-forged",
          mechanisms: [
            { mechanism: "generated-tests", status: "pass", evidenceRefs: ["ev-1"], verdictIds: [], detail: "trust me" },
            { mechanism: "evals", status: "pass", evidenceRefs: ["ev-2"], verdictIds: [], detail: "trust me" },
            { mechanism: "critic", status: "pass", evidenceRefs: ["ev-3"], verdictIds: [], detail: "trust me" },
          ],
          overall: "pass",
          measurement: undefined,
          ranAt: new Date().toISOString(),
        } as unknown as VerifiedReport
        expect(isVerifiedReport(forged)).toBe(false)
        const err = yield* Effect.flip(gate.promote(forged))
        expect(err).toBeInstanceOf(GateRejection)
        if (!(err instanceof GateRejection)) throw new Error("expected GateRejection")
        // Defense in depth: the brand check fires first on a forged value;
        // a pass-shaped report with real verdicts but missing evidence fails
        // on the executable-evidence check instead (see arm finalize tests).
        expect(err.reason.length).toBeGreaterThan(0)
        // State untouched: still quarantined, still not live.
        expect((yield* store.get("skill-forged")).state).toBe("quarantined")
        const liveErr = yield* Effect.flip(store.resolveForLive("skill-forged"))
        expect(liveErr._tag).toBe("QuarantineViolation")
      }),
    ),
  )

  it.effect("reject marks the candidate rejected and records the rejection", () =>
    withGate((gate, store, honesty) =>
      Effect.gen(function* () {
        const candidate = makeCandidate({ skillId: "skill-reject" })
        yield* store.quarantine(candidate)
        // A genuinely failing report from the arm (executor output mismatch).
        const arm = yield* VerificationArm
        const bad = makeCandidate({
          skillId: "skill-reject",
          behaviorCases: [{ caseId: "case-1", description: "wrong", input: { q: 1 }, expect: { nope: true } }],
        })
        const report = yield* arm.verify(bad)
        expect(report.overall).toBe("fail")
        const rejected = yield* gate.reject(candidate.skillId, report, "generated tests failed")
        expect(rejected.state).toBe("rejected")
        expect(rejected.evidenceRefs.length).toBeGreaterThan(0)
        // The rejection is in the honesty ledger.
        const claims = yield* honesty.claimsForTurn("learning", `gate:${candidate.skillId}`)
        expect(claims.length).toBe(1)
        expect(claims[0]!.claim.text).toContain("REJECTED")
        expect(claims[0]!.claim.text).toContain("generated tests failed")
      }),
    ),
  )

  it.effect("double promotion fails typed; the first promotion stands", () =>
    withGate((gate, store) =>
      Effect.gen(function* () {
        const candidate = makeCandidate({ skillId: "skill-double" })
        yield* store.quarantine(candidate)
        const verified = yield* verifyPassing(candidate)
        yield* gate.promote(verified)
        const err = yield* Effect.flip(gate.promote(verified))
        expect(err).toBeInstanceOf(QuarantineError)
        expect((yield* store.get(candidate.skillId)).state).toBe("trusted")
      }),
    ),
  )

  it.effect("prompt-only candidate end-to-end: never promotable, never live", () =>
    withGate(
      (gate, store) =>
        Effect.gen(function* () {
          const candidate = makePromptOnlyCandidate("skill-never")
          yield* store.quarantine(candidate)
          yield* store.markVerifying(candidate.skillId)
          const arm = yield* VerificationArm
          const report = yield* arm.verify(candidate)
          expect(report.overall).toBe("fail")
          // finalize refuses -> there is no VerifiedReport -> promote is
          // unreachable (compile-time). At runtime the record stays put.
          const err = yield* Effect.flip(arm.finalize(report))
          expect(err._tag).toBe("UnverifiedReport")
          expect((yield* store.get(candidate.skillId)).state).toBe("verifying")
          const liveErr = yield* Effect.flip(store.resolveForLive(candidate.skillId))
          expect(liveErr._tag).toBe("QuarantineViolation")
        }),
      testArmConfig({ evalCases: [] }),
    ),
  )
})
