/**
 * learning/gate.ts — the evidence gate: quarantined → trusted.
 *
 * THE HARD STRUCTURAL RULE: a candidate whose "evidence" is prompt-claimed
 * only (LLM assertion with no executable check behind it) can NEVER clear
 * this gate. Enforcement is two-deep:
 *
 * 1. TYPE LEVEL — `promote` accepts only `VerifiedReport`. The brand is
 *    minted solely by the verification arm's `finalize` on a passing
 *    report where every mechanism carries executable evidence (see arm.ts).
 *    A prompt-only candidate cannot produce one: `verify` fails all three
 *    mechanisms (no behavior contract → no checks; no held-out evals pass;
 *    critic assertion alone is recorded evidence, never sufficient), so
 *    `finalize` refuses with `UnverifiedReport`. Promotion of a prompt-only
 *    candidate is a TYPE ERROR, not a policy violation.
 * 2. RUNTIME DEFENSE-IN-DEPTH — `promote` re-validates the report's shape
 *    (overall pass, all three mechanisms passing, ≥1 judge verdict behind
 *    generated-tests and evals, ≥1 recorded critic evidence). A forged
 *    value smuggled past the type system still fails closed.
 *
 * "LLM proposes, evidence disposes."
 */
import { Context, Data, Effect, Layer } from "effect"

import { HonestyService, type HonestyError } from "../../honesty/src/index.js"
import { isVerifiedReport, type VerificationReport, type VerifiedReport } from "./arm.js"
import { QuarantineError, QuarantineStore, type QuarantineRecord } from "./quarantine.js"

export class GateError extends Data.TaggedError("GateError")<{
  readonly reason: string
}> {}

/** The gate refused promotion. Recorded in the ledger — rejections are never silent. */
export class GateRejection extends Data.TaggedError("GateRejection")<{
  readonly skillId: string
  readonly reason: string
}> {}

export interface EvidenceGateShape {
  /**
   * Promote quarantined → trusted. Requires `VerifiedReport`: the type
   * system makes prompt-only promotion unrepresentable.
   */
  readonly promote: (
    report: VerifiedReport,
  ) => Effect.Effect<QuarantineRecord, GateError | GateRejection | QuarantineError | HonestyError>
  /**
   * Record a failed verification: mark the candidate rejected and write the
   * rejection (with its evidence refs) into the honesty ledger.
   */
  readonly reject: (
    skillId: string,
    report: VerificationReport,
    reason: string,
  ) => Effect.Effect<QuarantineRecord, GateError | QuarantineError | HonestyError>
}

export class EvidenceGate extends Context.Service<EvidenceGate, EvidenceGateShape>()(
  "aimy/learning/EvidenceGate",
) {}

/** Defense-in-depth re-validation: the brand says pass; the gate checks anyway. */
const validateReport = (report: VerificationReport): string | undefined => {
  if (!isVerifiedReport(report)) return "report is not a VerifiedReport (brand missing)"
  if (report.overall !== "pass") return "report overall is not pass"
  const byName = new Map(report.mechanisms.map((m) => [m.mechanism, m]))
  const generated = byName.get("generated-tests")
  const evals = byName.get("evals")
  const critic = byName.get("critic")
  if (!generated || generated.status !== "pass" || generated.verdictIds.length === 0) {
    return "generated-tests lack executable evidence"
  }
  if (!evals || evals.status !== "pass" || evals.verdictIds.length === 0) {
    return "evals lack executable evidence"
  }
  if (!critic || critic.status !== "pass" || critic.evidenceRefs.length === 0) {
    return "critic lacks recorded evidence"
  }
  return undefined
}

export const EvidenceGateLive: Layer.Layer<EvidenceGate, never, HonestyService | QuarantineStore> = Layer.effect(
  EvidenceGate,
  Effect.gen(function* () {
    const honesty = yield* HonestyService
    const store = yield* QuarantineStore

    const promote: EvidenceGateShape["promote"] = (report) =>
      Effect.gen(function* () {
        const invalid = validateReport(report)
        if (invalid !== undefined) {
          return yield* Effect.fail(new GateRejection({ skillId: report.skillId, reason: invalid }))
        }
        const claim = yield* honesty.recordClaim({
          sessionId: "learning",
          turnId: `gate:${report.skillId}`,
          text: `evidence gate PROMOTED ${report.skillId} to trusted (report ${report.reportId})`,
          kind: "task-result",
        })
        // The gate's evidence IS the verification report: each mechanism's
        // result (with its verdict ids and ledger evidence refs) is already
        // in the ledger under the verify claim; the report id links them.
        for (const m of report.mechanisms) {
          yield* honesty.attachEvidence(claim.claimId, {
            kind: "source",
            ref: `verification-report:${report.reportId}:${m.mechanism}`,
            summary: `${m.mechanism}: ${m.status} — ${m.detail.slice(0, 160)}`,
          })
        }
        return yield* store.applyPromotion(report)
      })

    const reject: EvidenceGateShape["reject"] = (skillId, report, reason) =>
      Effect.gen(function* () {
        const claim = yield* honesty.recordClaim({
          sessionId: "learning",
          turnId: `gate:${skillId}`,
          text: `evidence gate REJECTED ${skillId}: ${reason}`,
          kind: "task-result",
        })
        for (const m of report.mechanisms) {
          yield* honesty.attachEvidence(claim.claimId, {
            kind: "source",
            ref: `verification-report:${report.reportId}:${m.mechanism}`,
            summary: `${m.mechanism}: ${m.status} — ${m.detail.slice(0, 160)}`,
          })
        }
        const evidenceRefs = report.mechanisms.flatMap((m) => m.evidenceRefs)
        return yield* store.applyRejection(skillId, reason, [claim.claimId, ...evidenceRefs])
      })

    return EvidenceGate.of({ promote, reject })
  }),
)
