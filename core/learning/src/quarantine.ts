/**
 * learning/quarantine.ts — Quarantine: the structural holding state for
 * newly written or modified skills (M6 Track 2).
 *
 * Rules (architecture §2.8, §3.5):
 * - A new/modified skill lands in quarantine FIRST. It is loadable only in
 *   sandboxed T0-observed runs, never in live tasks, never auto-invoked by
 *   the model.
 * - Quarantine is a STRUCTURAL STATE, not a flag the skill can clear
 *   itself: the record is inert data; only the `QuarantineStore` service
 *   transitions states, and `trusted` is reachable only through
 *   `applyPromotion`, which requires a `VerifiedReport` (see arm.ts —
 *   the type system makes self-clearing unrepresentable).
 * - Lifecycle STATE and OUTCOME records are separate types
 *   (Hermes #68499): `QuarantineRecord` is the current state;
 *   `history` is the append-only outcome log.
 */
import { Clock, Context, Data, Effect, Layer, Ref } from "effect"

import type { Tier } from "../../substrate/index.js"
import type { VerifiedReport } from "./arm.js"
import type { CandidateSkill } from "./types.js"

export class QuarantineError extends Data.TaggedError("QuarantineError")<{
  readonly reason: string
}> {}

export class QuarantineViolation extends Data.TaggedError("QuarantineViolation")<{
  readonly skillId: string
  readonly reason: string
}> {}

export type QuarantineState = "quarantined" | "verifying" | "trusted" | "rejected"

/** Outcome log entry — separate from the state it describes. */
export interface QuarantineTransition {
  readonly from: QuarantineState
  readonly to: QuarantineState
  readonly at: string // ISO timestamp
  readonly evidenceRefs: ReadonlyArray<string>
  readonly detail: string
}

export interface QuarantineRecord {
  readonly skillId: string
  readonly name: string
  readonly version: string
  readonly state: QuarantineState
  readonly authorLane: string
  readonly quarantinedAt: string // ISO timestamp
  /** Append-only outcome log. History is never rewritten. */
  readonly history: ReadonlyArray<QuarantineTransition>
  /** Honesty-ledger evidence ids backing the current state. */
  readonly evidenceRefs: ReadonlyArray<string>
  /** Verification report that promoted this record, if any. */
  readonly reportId: string | undefined
}

export interface QuarantineStoreShape {
  /**
   * Land a newly written or modified skill in quarantine.
   * Re-quarantining an existing record fails — a modified skill is a NEW
   * candidate (new skillId/version), never a silent overwrite.
   */
  readonly quarantine: (candidate: CandidateSkill) => Effect.Effect<QuarantineRecord, QuarantineError>
  readonly get: (skillId: string) => Effect.Effect<QuarantineRecord, QuarantineError>
  /**
   * Mark verification in progress (quarantined → verifying).
   * Called by the verification arm; not reachable by the skill itself.
   */
  readonly markVerifying: (skillId: string) => Effect.Effect<QuarantineRecord, QuarantineError>
  /**
   * THE promotion path. Requires a `VerifiedReport` — the brand is minted
   * only by the verification arm's `finalize` on a passing report
   * (see arm.ts). There is no other constructor: the skill cannot promote
   * itself, and no caller can forge the report type.
   */
  readonly applyPromotion: (report: VerifiedReport) => Effect.Effect<QuarantineRecord, QuarantineError>
  /** Mark a failed candidate rejected; rejections are recorded, never silent. */
  readonly applyRejection: (
    skillId: string,
    reason: string,
    evidenceRefs: ReadonlyArray<string>,
  ) => Effect.Effect<QuarantineRecord, QuarantineError>
  /**
   * Execute a run of the skill. Allowed ONLY when the record is quarantined
   * or verifying, the sandbox tier is T0, and an observer witnesses the
   * run. Anything else → `QuarantineViolation`. There is no auto-invoke
   * path: the model cannot trigger this on its own.
   */
  readonly runSandboxed: <A, E>(
    skillId: string,
    tier: Tier,
    observed: boolean,
    run: Effect.Effect<A, E>,
  ) => Effect.Effect<A, QuarantineViolation | E>
  /**
   * Resolve a skill for LIVE task use. Succeeds ONLY for `trusted`
   * records. Quarantined/verifying/rejected → `QuarantineViolation`.
   */
  readonly resolveForLive: (skillId: string) => Effect.Effect<QuarantineRecord, QuarantineViolation>
}

export class QuarantineStore extends Context.Service<QuarantineStore, QuarantineStoreShape>()(
  "aimy/learning/QuarantineStore",
) {}

const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())

const transition = (
  record: QuarantineRecord,
  to: QuarantineState,
  at: string,
  evidenceRefs: ReadonlyArray<string>,
  detail: string,
): QuarantineRecord => ({
  ...record,
  state: to,
  evidenceRefs: [...record.evidenceRefs, ...evidenceRefs],
  history: [...record.history, { from: record.state, to, at, evidenceRefs, detail }],
})

export const QuarantineStoreLive: Layer.Layer<QuarantineStore> = Layer.effect(
  QuarantineStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make(new Map<string, QuarantineRecord>())

    const getOrFail = (skillId: string): Effect.Effect<QuarantineRecord, QuarantineError> =>
      Effect.gen(function* () {
        const records = yield* Ref.get(ref)
        const record = records.get(skillId)
        if (!record) return yield* Effect.fail(new QuarantineError({ reason: `unknown skill: ${skillId}` }))
        return record
      })

    const quarantine: QuarantineStoreShape["quarantine"] = (candidate) =>
      Effect.gen(function* () {
        const records = yield* Ref.get(ref)
        if (records.has(candidate.skillId)) {
          return yield* Effect.fail(
            new QuarantineError({
              reason: `skill ${candidate.skillId} is already quarantined (state ${records.get(candidate.skillId)?.state}); submit a modified skill as a new candidate`,
            }),
          )
        }
        const at = yield* nowIso
        const record: QuarantineRecord = {
          skillId: candidate.skillId,
          name: candidate.name,
          version: candidate.version,
          state: "quarantined",
          authorLane: candidate.authorLane,
          quarantinedAt: at,
          history: [
            {
              from: "quarantined",
              to: "quarantined",
              at,
              evidenceRefs: [],
              detail: `landed in quarantine; author lane ${candidate.authorLane}`,
            },
          ],
          evidenceRefs: [],
          reportId: undefined,
        }
        yield* Ref.update(ref, (m) => new Map(m).set(candidate.skillId, record))
        return record
      })

    const markVerifying: QuarantineStoreShape["markVerifying"] = (skillId) =>
      Effect.gen(function* () {
        const record = yield* getOrFail(skillId)
        if (record.state !== "quarantined") {
          return yield* Effect.fail(
            new QuarantineError({ reason: `cannot start verification from state ${record.state}` }),
          )
        }
        const at = yield* nowIso
        const next = transition(record, "verifying", at, [], "verification arm started")
        yield* Ref.update(ref, (m) => new Map(m).set(skillId, next))
        return next
      })

    const applyPromotion: QuarantineStoreShape["applyPromotion"] = (report) =>
      Effect.gen(function* () {
        const record = yield* getOrFail(report.skillId)
        if (record.state !== "quarantined" && record.state !== "verifying") {
          return yield* Effect.fail(
            new QuarantineError({ reason: `cannot promote from state ${record.state}` }),
          )
        }
        const at = yield* nowIso
        const evidenceRefs = report.mechanisms.flatMap((m) => m.evidenceRefs)
        const next: QuarantineRecord = {
          ...transition(record, "trusted", at, evidenceRefs, `evidence gate passed; report ${report.reportId}`),
          reportId: report.reportId,
        }
        yield* Ref.update(ref, (m) => new Map(m).set(report.skillId, next))
        return next
      })

    const applyRejection: QuarantineStoreShape["applyRejection"] = (skillId, reason, evidenceRefs) =>
      Effect.gen(function* () {
        const record = yield* getOrFail(skillId)
        if (record.state === "trusted") {
          return yield* Effect.fail(new QuarantineError({ reason: "cannot reject a trusted skill" }))
        }
        const at = yield* nowIso
        const next = transition(record, "rejected", at, evidenceRefs, `rejected: ${reason}`)
        yield* Ref.update(ref, (m) => new Map(m).set(skillId, next))
        return next
      })

    const runSandboxed: QuarantineStoreShape["runSandboxed"] = (skillId, tier, observed, run) =>
      Effect.gen(function* () {
        const records = yield* Ref.get(ref)
        const record = records.get(skillId)
        if (!record) {
          return yield* Effect.fail(new QuarantineViolation({ skillId, reason: "unknown skill" }))
        }
        if (record.state !== "quarantined" && record.state !== "verifying") {
          return yield* Effect.fail(
            new QuarantineViolation({ skillId, reason: `state ${record.state} is not runnable in quarantine` }),
          )
        }
        if (tier !== "T0") {
          return yield* Effect.fail(
            new QuarantineViolation({ skillId, reason: `quarantined runs require T0 sandbox, got ${tier}` }),
          )
        }
        if (!observed) {
          return yield* Effect.fail(
            new QuarantineViolation({ skillId, reason: "quarantined runs require an observer witness" }),
          )
        }
        return yield* run
      })

    const resolveForLive: QuarantineStoreShape["resolveForLive"] = (skillId) =>
      Effect.gen(function* () {
        const records = yield* Ref.get(ref)
        const record = records.get(skillId)
        if (!record || record.state !== "trusted") {
          return yield* Effect.fail(
            new QuarantineViolation({
              skillId,
              reason: record ? `skill is ${record.state}, not trusted` : "unknown skill",
            }),
          )
        }
        return record
      })

    return QuarantineStore.of({
      quarantine,
      get: getOrFail,
      markVerifying,
      applyPromotion,
      applyRejection,
      runSandboxed,
      resolveForLive,
    })
  }),
)
